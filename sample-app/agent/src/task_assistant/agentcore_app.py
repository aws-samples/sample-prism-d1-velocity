"""AgentCore Runtime entrypoint for the Task Assistant Agent."""

import os

from bedrock_agentcore.runtime import BedrockAgentCoreApp
from .agent import create_agent
from .config import AgentConfig

app = BedrockAgentCoreApp()


@app.entrypoint
async def invoke(payload: dict, context) -> dict:
    """Handle incoming requests from AgentCore Runtime."""
    config = AgentConfig(
        task_api_url=os.getenv("TASK_API_URL", "http://localhost:3000"),
        aws_region=os.getenv("AWS_REGION", "us-west-2"),
    )

    agent = create_agent(config=config, verbose=False)
    prompt = payload.get("prompt", "")
    result = agent(prompt)

    return {
        "response": str(result),
        "session_id": getattr(context, "session_id", None),
    }


if __name__ == "__main__":
    app.run()
