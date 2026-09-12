FROM node:20-alpine
WORKDIR /app

# Instala dependencias primero (mejor caché de capas)
COPY package.json ./
RUN npm install --omit=dev

# Copia el código (incluye services/ y el keyfile de Google en build local)
COPY . .

EXPOSE 3000
# Amplía el heap de Node: el contenedor tiene 512MB pero Node por defecto se limita a
# ~256MB → OOM ("Reached heap limit"). 400MB deja margen para overhead/external.
CMD ["node", "--max-old-space-size=400", "server.js"]
