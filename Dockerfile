# Image for the Cloud Run job. Written out rather than left to buildpacks so
# the entrypoint is explicit: this container runs one sync and exits.
FROM node:22-slim

WORKDIR /app

# Dependencies first, so edits to src/ do not invalidate the npm layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts/cloud-run-entrypoint.js ./scripts/

# In-memory on Cloud Run and gone when the task ends, which is what we want
# for a directory that briefly holds refresh tokens.
ENV GCAL_SYNC_HOME=/tmp/gcal-sync

CMD ["node", "scripts/cloud-run-entrypoint.js"]
