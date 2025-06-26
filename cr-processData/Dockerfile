# Use the official Node.js 22 image.
FROM node:22-slim

# Create and change to the app directory.
WORKDIR /usr/src/app

# Copy application dependency manifests to the container image.
COPY package*.json ./

# Install production dependencies.
RUN npm install --only=production

# Copy local code to the container image.
COPY . .

# Run the anpplication.
ENTRYPOINT ["node", "index.js"]