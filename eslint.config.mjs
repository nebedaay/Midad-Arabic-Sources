// ESLint flat config for Midad Arabic Sources.
//
// Runs the SAME rules the Obsidian community-directory review uses
// (`eslint-plugin-obsidianmd`), plus the type-checked typescript-eslint set it
// bundles, so a local `npm run lint` reports what a submission would.
//
// Dev-only: nothing here ships in main.js.

import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

/**
 * Rules the directory review reports as WARNINGS. The plugin's recommended
 * config raises them to errors; matching the review's severity keeps
 * `npm run lint` exit code meaningful — it should fail on what would fail a
 * submission, not on the long tail of strictness rules.
 */
const reviewWarnings = {
  "@typescript-eslint/no-unsafe-assignment": "warn",
  "@typescript-eslint/no-unsafe-member-access": "warn",
  "@typescript-eslint/no-unsafe-call": "warn",
  "@typescript-eslint/no-unsafe-argument": "warn",
  "@typescript-eslint/no-unsafe-return": "warn",
  "@typescript-eslint/no-unsafe-enum-comparison": "warn",
  "@typescript-eslint/no-explicit-any": "warn",
  "@typescript-eslint/no-floating-promises": "warn",
  "@typescript-eslint/no-misused-promises": "warn",
  "@typescript-eslint/no-unnecessary-type-assertion": "warn",
  "@typescript-eslint/no-require-imports": "warn",
  "@typescript-eslint/no-base-to-string": "warn",
  "@typescript-eslint/prefer-promise-reject-errors": "warn",
  // The wrapper rule that reports console logging (and other builtin rules the
  // directory only warns about). `no-console` cannot be disabled per-line — the
  // plugin forbids it — so severity is the only lever, and the review warns.
  "obsidianmd/rule-custom-message": "warn",
  // Sentence case for UI text. The option object REPLACES the plugin's
  // defaults, so the default brand/acronym lists are repeated here in full and
  // the plugin's own proper nouns are appended. (Without this, declaring any
  // brand would silently drop `Obsidian`, `Zotero`, `Gemini`, `API`, … and
  // flag every UI string that uses them.)
  "obsidianmd/ui/sentence-case": [
    "warn",
    {
      mode: "loose",
      brands: [
        // OS
        "iOS", "iPadOS", "macOS", "Windows", "Android", "Linux",
        // Obsidian
        "Obsidian", "Obsidian Sync", "Obsidian Publish",
        // Services/APIs
        "Google", "Gemini", "Vertex AI", "OpenAI", "GPT", "Anthropic", "Claude", "Cursor", "Microsoft",
        // Cloud storage
        "Google Drive", "Dropbox", "OneDrive", "iCloud Drive",
        // Communication platforms
        "YouTube", "Slack", "Discord", "Telegram", "WhatsApp", "Twitter", "X",
        // Productivity tools
        "Readwise", "Zotero", "Excalidraw", "Mermaid",
        // Languages
        "Markdown", "LaTeX", "JavaScript", "TypeScript",
        // Development tools
        "Node.js", "npm", "pnpm", "Yarn", "Git", "GitHub", "GitLab",
        // Other tools
        "Anki", "CalDAV", "CardDAV", "Evernote", "IntelliJ IDEA", "Jekyll", "Logseq", "Notion", "PyCharm", "React", "Reddit", "Roam Research", "Svelte", "VS Code", "Visual Studio Code", "WebDAV", "WebStorm",
        // Midad Arabic Sources
        "Midad", "Midad Arabic Sources", "Turath", "Arabic", "Python", "Eta", "DeepSeek", "CAMeL",
        "Qurʾān", "Qur’ān", "Qur'ān", "Qur’an", "Qur'an",
        "GEMINI_API_KEY", "GOOGLE_API_KEY",
      ],
      acronyms: [
        // Defaults
        "API", "HTTP", "HTTPS", "URL", "DNS", "TCP", "IP", "SSH", "TLS", "SSL", "FTP", "SFTP", "SMTP",
        "JSON", "XML", "HTML", "CSS", "PDF", "CSV", "YAML", "SQL", "PNG", "JPG", "JPEG", "GIF", "SVG",
        "2FA", "MFA", "OAuth", "JWT", "LDAP", "SAML", "SDK", "IDE", "CLI", "GUI", "CRUD", "REST", "SOAP",
        "CPU", "GPU", "RAM", "SSD", "USB", "UI", "OK", "RSS", "S3", "ID", "UUID", "GUID", "SHA", "MD5",
        "ASCII", "UTF-8", "UTF-16", "DOM", "CDN", "FAQ", "AI", "ML", "LLM",
        // Midad Arabic Sources
        "ETA", "MOC", "OCR", "CSL", "SQLite", "BERT", "MLE", "CAMeL", "PDFS",
      ],
      ignoreWords: ["Use", "Copy", "Manage", "Settings", "Community", "Cursor", "cursor"],
      ignoreRegex: ["mas-", "@[a-z]", "midad-arabic-sources", "app\\.turath\\.io"],
    },
  ],
};

export default defineConfig([
  {
    // Build output, bundled assets, the Python pipeline, and the ETA templates
    // are not shipped TypeScript source.
    ignores: [
      "main.js",
      "node_modules/**",
      "scripts/**",
      "midad-arabic-sources-import-templates/**",
      "src/assets.generated.ts",
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*"],
        },
      },
    },
    rules: {
      ...reviewWarnings,
      // TypeScript already reports undefined identifiers, and the browser/node
      // globals this plugin legitimately uses are not in the base config's
      // list — `no-undef` here is all false positives.
      "no-undef": "off",
    },
  },
]);
