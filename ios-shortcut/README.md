# iOS Shortcut — Share Sheet upload

Lets you send any file, photo, or document to the archive straight from the iOS Share Sheet.

## Setup

1. On iPhone, open the **Shortcuts** app.
2. Create a new shortcut with the following actions:
   - **Accept**: Images, PDFs, Files from **Share Sheet**.
   - **Get Contents of URL**:
     - URL: `https://YOUR-DEPLOYED-URL.vercel.app/api/shortcut/upload` (or `http://your-mac.local:3002/...` for local testing)
     - Method: `POST`
     - Headers:
       - `Authorization: Bearer YOUR_SHORTCUT_TOKEN` *(match `SHORTCUT_MASTER_TOKEN` in `.env.local`, OR a token row in `shortcut_tokens`)*
     - Request Body: `Form`
       - `file`: the Shortcut Input (type: File)
       - *(optional)* `batch`: a text input prompt
       - *(optional)* `tags`: a text input prompt
   - **Show Result** (optional): display the returned JSON so you get visual confirmation.
3. Rename the shortcut to something like **"Archive it"**.
4. In the shortcut's settings, enable **"Use as Share Sheet"** and tick the file types you want (Images, PDFs, Documents).

Now any app that offers a Share Sheet — Mail, Safari, Files, WhatsApp — will show "Archive it" as a target.

## Generating a token

Option A: set `SHORTCUT_MASTER_TOKEN=some-random-string` in `.env.local` (simple for single-user).

Option B: insert a row in the `shortcut_tokens` table with your user_id and a random token string.

Either way, the iOS Shortcut puts this token in the `Authorization: Bearer ...` header.

## Security note

Treat the token like a password. It's a long-lived secret that can post documents to the archive on your behalf.
