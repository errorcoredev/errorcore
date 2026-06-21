FROM node:20.11.1-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY vendor/errorcore-0.2.0.tgz /errorcore-0.2.0.tgz
COPY apps/conduit-api/package.json apps/conduit-api/package-lock.json ./

RUN npm ci --ignore-scripts --omit=dev
RUN npm install --ignore-scripts --no-save esbuild@0.25.12

COPY apps/conduit-api/app.js ./app.js
COPY apps/conduit-api/config ./config
COPY apps/conduit-api/models ./models
COPY apps/conduit-api/routes ./routes
COPY apps/conduit-api/errorcore-bootstrap.js ./errorcore-bootstrap.js
COPY apps/conduit-api/server.instrumented.js ./server.instrumented.js

RUN npx esbuild@0.25.12 server.instrumented.js --bundle --platform=node --target=node20 --minify --sourcemap=external --external:pg --external:pg/* --external:pg-native --outfile=dist/server.js
RUN test -f dist/server.js.map
RUN node -e "const fs=require('fs');const lines=fs.readFileSync('dist/server.js','utf8').split(/\r?\n/);const long=lines.filter((line)=>line.length>500).length;if(long<1){process.exit(1)}"

EXPOSE 3000

CMD ["node", "--enable-source-maps", "--unhandled-rejections=strict", "dist/server.js"]
