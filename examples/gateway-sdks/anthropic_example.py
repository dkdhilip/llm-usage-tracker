"""Minimal Anthropic request through the gateway. Setup lives in .env — see .env.example."""

import os

from gateway_client import anthropic_client

client = anthropic_client()

message = client.messages.create(
    model=os.environ.get("EXAMPLE_MODEL", "claude-haiku-4-5-20251001"),
    max_tokens=64,  # required by the Anthropic API
    messages=[{"role": "user", "content": "Say hello in five words."}],
)
print("id:     ", message.id)  # the dashboard's Request ID for this call
print("model:  ", message.model)
print("reply:  ", message.content[0].text)
print("tokens: ", message.usage.input_tokens + message.usage.output_tokens)
