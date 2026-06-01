// Vercel serverless entry. Wrap the Express app in an explicit handler function
// so Vercel's export validator never mis-detects the app instance.
import { app } from '../app.js';
export default function handler(req, res) {
  return app(req, res);
}
