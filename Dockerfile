FROM node:24-bookworm-slim
WORKDIR /app
COPY server.mjs ./server.mjs
COPY public ./public
ENV NODE_ENV=production
ENV PORT=4173
ENV ARCHFLOW_DATA_DIR=/app/data
VOLUME ["/app/data"]
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
