FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

RUN mkdir -p data

EXPOSE 3000

# Seed admin user on first run, then start
CMD ["sh", "-c", "node seed.js && node server.js"]
