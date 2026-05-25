FROM public.ecr.aws/docker/library/python:3.13-slim

WORKDIR /app

# Install dependencies first for layer caching
COPY pyproject.toml .
RUN pip install --no-cache-dir .

# Copy agent code
COPY task_assistant/ task_assistant/

# AgentCore Runtime expects the app on port 8080
EXPOSE 8080

# Run as module so task_assistant package is importable
CMD ["python", "-m", "task_assistant.agentcore_app"]
