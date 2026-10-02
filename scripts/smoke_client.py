"""Run against npm start: pip install openai && python scripts/smoke_client.py."""
import json
import os
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:4000/v1",
    api_key=os.environ.get("LOCAL_API_KEY", "local"),
    timeout=200,
    max_retries=0,
)
messages = [{"role": "user", "content": "Add 17 and 25 using the add function."}]
tools = [{"type": "function", "function": {
    "name": "add",
    "parameters": {
        "type": "object",
        "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}},
        "required": ["a", "b"],
        "additionalProperties": False,
    },
}}]
response = client.chat.completions.create(
    model="gpt-6.1-sol", messages=messages, tools=tools,
    tool_choice="required", temperature=0, reasoning_effort="low",
    parallel_tool_calls=False,
)
message = response.choices[0].message
assert response.choices[0].finish_reason == "tool_calls"
assert len(message.tool_calls) == 1
call = message.tool_calls[0]
assert call.function.name == "add"
args = json.loads(call.function.arguments)
assert args["a"] + args["b"] == 42
messages.append({"role": "assistant", "content": message.content,
                 "tool_calls": [call.model_dump()]})
messages.append({"role": "tool", "tool_call_id": call.id,
                 "content": json.dumps({"result": args["a"] + args["b"]})})
answer = client.chat.completions.create(
    model="gpt-6.1-sol", messages=messages, tools=tools,
    tool_choice="none", temperature=0, reasoning_effort="low",
)
assert answer.choices[0].finish_reason == "stop"
assert "42" in answer.choices[0].message.content
print("PASS: Python OpenAI client, real HTTP, function call + tool result = 42.")
