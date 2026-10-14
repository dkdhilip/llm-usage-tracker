"""Minimal OpenAI request through the gateway. Setup lives in .env — see .env.example."""

import os

from gateway_client import openai_client

client = openai_client()

response = client.chat.completions.create(
    model=os.environ.get("EXAMPLE_MODEL", "openai/gpt-4o-mini"),  # <provider>/<model> works with any key
    messages=[{"role": "user", "content": "Say hello in five words."}],
    max_tokens=20,
)
print("id:     ", response.id)  # the dashboard's Request ID for this call
print("model:  ", response.model)
print("reply:  ", response.choices[0].message.content)
print("tokens: ", response.usage.total_tokens)
