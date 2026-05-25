FROM public.ecr.aws/docker/library/node:20-slim
WORKDIR /app
COPY . .
ENV PRISM_ECS_MODE=true PORT=3120
EXPOSE 3120
CMD ["node", "server.js"]
