# Build the frontend, then serve it from the FastAPI app in one container.
FROM node:24-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend/ backend/
COPY --from=frontend /app/frontend/dist frontend/dist

# Documents and the index live on a mounted volume so they survive restarts.
ENV FFU_DATA_DIR=/data/ffu \
    FFU_DB_PATH=/data/ffu.db \
    PORT=8000
RUN mkdir -p /data/ffu

WORKDIR /app/backend
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
