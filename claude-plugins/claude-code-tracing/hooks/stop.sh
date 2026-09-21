#!/bin/bash
# Stop - Create trace span with input and output
source "$(dirname "$0")/common.sh"
check_requirements

input=$(cat 2>/dev/null || echo '{}')
[[ -z "$input" ]] && input='{}'

resolve_session "$input"

session_id=$(get_state "session_id")
trace_id=$(get_state "current_trace_id")
[[ -z "$session_id" || -z "$trace_id" ]] && exit 0

trace_span_id=$(get_state "current_trace_span_id")
trace_start_time=$(get_state "current_trace_start_time")
user_prompt=$(get_state "current_trace_prompt")
project_name=$(get_state "project_name")
trace_count=$(get_state "trace_count")

# Parse transcript for AI response and tokens. Only the lines this turn added
# are read, so the span carries this turn's output and not the whole growing
# conversation. Jumi: one jq pass over the tail, not 7 jq processes per
# assistant line — that cost scaled with run length, ate the job timeout, and
# hit Claude Code's 600s Stop-hook cap so the Turn span (model + tokens) was
# discarded. @sh so a multiline join does not break the four assignments.
transcript=$(echo "$input" | jq -r '.transcript_path // empty' 2>/dev/null || echo "")
output="" model="" in_tokens=0 out_tokens=0

if [[ -f "$transcript" ]]; then
  start_line=$(get_state "trace_start_line")
  skip_lines=$((${start_line:-0}))
  _parsed=$(tail -n +"$((skip_lines + 1))" "$transcript" | jq -sr '
    [.[]|select(.type=="assistant")] as $a |
    ([$a[]|.message.content|if type=="array" then [.[]|select(.type=="text")|.text]|join("\n") else . end|select(type=="string" and .!="")]|join("\n")) as $out |
    ($a[-1].message.model // "") as $model |
    ([$a[]|.message.usage|((.input_tokens//0)+(.cache_read_input_tokens//0)+(.cache_creation_input_tokens//0))]|add // 0) as $in |
    ([$a[]|.message.usage.output_tokens//0]|add // 0) as $out_tok |
    @sh "output=\($out) model=\($model) in_tokens=\($in) out_tokens=\($out_tok)"
  ' 2>/dev/null) || _parsed=""
  [[ -n "$_parsed" ]] && eval "$_parsed"
  unset _parsed
fi

# Jumi: slice, never `head -c`. Under `set -o pipefail` head exits at its byte
# limit and SIGPIPEs the writer, so the assignment reports 141 and `set -e`
# kills the hook before the Turn span is sent — for any value past the pipe
# buffer, i.e. exactly the inputs the truncation exists to handle. `output`
# holds every assistant text block of the turn, and under `claude -p` there is
# one turn per run, so 5000 is not the interesting size — 64 KiB is, and a Jumi
# run clears it routinely. Parameter expansion opens no pipe.
output="${output:0:5000}"
[[ -z "$output" ]] && output="(No response)"

# Compute total token count
total_tokens=$((in_tokens + out_tokens))

output_messages=$(jq -nc --arg out "$output" '[{"message.role":"assistant","message.content":$out}]')

user_id=$(get_state "user_id")

# `input.value` is present only when ARIZE_LOG_PROMPTS is on; see
# user_prompt_submit.sh.
attrs=$(jq -nc \
  --arg sid "$session_id" --arg num "$trace_count" --arg proj "$project_name" \
  --arg in "$user_prompt" --arg out "$output" --arg model "$model" \
  --arg uid "$user_id" \
  --argjson in_tok "$in_tokens" --argjson out_tok "$out_tokens" --argjson total_tok "$total_tokens" \
  --argjson out_msgs "$output_messages" \
  '{"session.id":$sid,"trace.number":$num,"project.name":$proj,"openinference.span.kind":"LLM","llm.model_name":$model,"llm.token_count.prompt":$in_tok,"llm.token_count.completion":$out_tok,"llm.token_count.total":$total_tok,"output.value":$out,"llm.output_messages":$out_msgs} + (if $in != "" then {"input.value":$in} else {} end) + (if $uid != "" then {"user.id":$uid} else {} end)')

span=$(build_span "Turn $trace_count" "LLM" "$trace_span_id" "$trace_id" "" "$trace_start_time" "$(get_timestamp_ms)" "$attrs")
send_span "$span" || true

del_state "current_trace_id"
del_state "current_trace_span_id"
del_state "current_trace_start_time"
del_state "current_trace_prompt"
log "Turn $trace_count sent"

# Opportunistic GC for environments without SessionEnd (e.g., Python Agent SDK)
if [[ $((trace_count % 5)) -eq 0 ]]; then
  gc_stale_state_files
fi
