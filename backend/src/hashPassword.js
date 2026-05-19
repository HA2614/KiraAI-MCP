import { hashPassword } from "./auth.js";

const password = process.argv[2] === "--env"
  ? process.env.KIRAAI_ADMIN_PASSWORD || ""
  : process.argv.slice(2).join(" ");

if (!password) {
  console.error("Usage: node backend/src/hashPassword.js <admin-password>");
  process.exit(1);
}

hashPassword(password)
  .then((hash) => {
    console.log(hash);
  })
  .catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
