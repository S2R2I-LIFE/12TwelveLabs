FROM node:20-alpine

WORKDIR /app

# Required for Prisma and native modules
RUN apk add --no-cache libc6-compat openssl

# Copy prisma schema first — postinstall runs `prisma generate` during npm install
COPY prisma ./prisma

# Install dependencies (cached layer — only re-runs when package.json/prisma changes)
COPY package.json package-lock.json* ./
RUN npm install

EXPOSE 3001

# Bind to all interfaces inside the container
ENV HOSTNAME=0.0.0.0
ENV NODE_ENV=development

CMD ["npm", "run", "dev"]
