/**
 * Sets the admin login for this installation.
 *
 *   npm run set-admin -- you@example.com "your-password"
 *
 * The password is salted and hashed into data/admin.json, which is gitignored,
 * so it never reaches the repository. Restart the app afterwards.
 */
import { setAdminCredentials } from "../server/admin-credentials";

const [email, password] = process.argv.slice(2);

if (!email || !password) {
  console.error("Usage: npm run set-admin -- <email> <password>");
  console.error('Example: npm run set-admin -- you@example.com "choose-a-strong-password"');
  process.exit(1);
}

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error(`"${email}" does not look like an email address.`);
  process.exit(1);
}

if (password.length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}

setAdminCredentials(email, password);
console.log(`Admin login set for ${email}.`);
console.log("Stored as a salted hash in data/admin.json (gitignored).");
console.log("Restart the app, then sign in with those details.");
