# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
# node-web-audio-api's native binding links against ALSA and fails to load without it, even for
# OfflineAudioContext, which never opens a device. The slim Node image does not ship libasound.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libasound2 \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS dev
ENV NODE_ENV=development
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

FROM deps AS test
COPY . .
RUN npm run lint
RUN npm run test

FROM deps AS build
ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA
COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS preview
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
