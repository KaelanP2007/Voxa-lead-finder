# Voxa Lead Finder - Render Version

This is the hosted web app version. It uses Google Places API (New), tracks called/not-called leads, and exports Excel files.

## Render setup

1. Upload this folder to a GitHub repo.
2. Go to Render.com -> New -> Web Service.
3. Connect the repo.
4. Use these settings:
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
5. Add Environment Variable:
   - Key: `GOOGLE_PLACES_API_KEY`
   - Value: your new Google Places API key
6. Deploy.

## Important

Do not put your API key inside the code. Use Render environment variables only.

The app stores leads in `data/leads.json`. On Render's free/basic instances, local files can reset after redeploys. For a permanent CRM, upgrade this to Supabase later.
