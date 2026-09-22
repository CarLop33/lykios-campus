# Lykios Campus · lanzamiento en 2 pasos

## Paso 1 · GitHub
1. En GitHub crea un repositorio **privado** llamado `lykios-campus`.
2. No añadas README, licencia ni .gitignore desde GitHub.
3. Descomprime `lykios-campus-vercel-import.zip` y sube **el contenido de la carpeta**, no la carpeta contenedora.
4. Confirma que en la raíz del repo aparecen `package.json`, `vercel.json`, `server.mjs`, `api/` y `public/`.

## Paso 2 · Vercel
1. Vercel → Add New → Project.
2. Importa `lykios-campus`.
3. No conectes aún `campus.lykiosacademy.com`.
4. Crea primero un **Preview Deployment**.
5. Conecta Neon/Postgres y Vercel Blob cuando Vercel lo solicite.
6. Añade solo variables de Preview; Stripe puede permanecer sin claves Live.
7. Ejecuta `npm run preflight:vercel` tras disponer de las variables.
8. Verifica `/api/health/live` y `/api/health/ready`.

No actives Vercel Pro ni Stripe Live hasta que el preview esté validado.
