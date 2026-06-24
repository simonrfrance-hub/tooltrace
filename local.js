// Local entry point: run a normal Node server. (On Vercel, api/index.js is used.)
import { app } from './app.js';

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Localizit running on http://localhost:${PORT}`));
