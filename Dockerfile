FROM node:20-alpine
WORKDIR /app

# Instala dependencias primero (mejor caché de capas)
COPY package.json ./
RUN npm install --omit=dev

# Copia el código (incluye services/ y el keyfile de Google en build local)
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
