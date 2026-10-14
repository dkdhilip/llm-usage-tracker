"""Minimal Gemini request through the gateway. Setup lives in .env — see .env.example."""

import os

from gateway_client import gemini_client

client = gemini_client()  # keep this reference: the SDK closes its HTTP session when it is collected

response = client.models.generate_content(
    model=os.environ.get("EXAMPLE_MODEL", "gemini-2.5-flash"),
    contents="Say hello in five words.",
)
print("model:  ", response.model_version)
print("reply:  ", response.text)
print("tokens: ", response.usage_metadata.total_token_count)
# Gemini responses carry no id the gateway can reuse: find this call on the dashboard by key label and time.
