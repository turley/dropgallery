// `dropgallery --setup` wizard. Prompts for the four config values, validates
// by doing a real PutObject + tag against the bucket (same calls the upload
// pipeline uses, so the documented minimum IAM policy is sufficient), and
// writes the config. Always runs CLI-mode — gallery.js sets DROPGALLERY_UI
// before importing this module.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { input, confirm, select } from "@inquirer/prompts";
import * as ini from "ini";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
} from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-providers";
import {
  CONFIG_PATH,
  HOME_CONFIG_PATH,
  configLookupPath,
  loadConfigs,
} from "./config.js";

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const DEFAULT_NAME = "default";
// Symbol sentinel for the picker's "+ Add a new destination" entry. A Symbol
// can't collide with a real destination name (which must match NAME_RE) the
// way a string sentinel like "__new__" could.
const ADD_NEW = Symbol("add-new");

const TICK = "\x1b[32m✓\x1b[0m";
const CROSS = "\x1b[31m✗\x1b[0m";
const WARN = "\x1b[33m⚠\x1b[0m";
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const BOLD = (s) => `\x1b[1m${s}\x1b[0m`;

function printPreamble() {
  process.stdout.write(`
${BOLD("DropGallery Setup")}

This walks through the four config values the tool needs. Before you
continue, you should already have set up the following on AWS:

  1. ${BOLD("S3 bucket")} — dedicated to this tool, with "Block all public access" on.
  2. ${BOLD("IAM user")} (or role) with at minimum ${DIM("s3:PutObject")} and
     ${DIM("s3:PutObjectTagging")} on that bucket.
  3. ${BOLD("AWS credentials")} for that user in ${DIM("~/.aws/credentials")} under a
     named profile. The fastest way: ${DIM("aws configure --profile gallery")}.
  4. ${BOLD("CloudFront distribution")} with OAC, pointed at the bucket.
  5. ${BOLD("ACM certificate")} attached to the distribution as a
     custom alternate domain (e.g. ${DIM("gallery.yourdomain.com")}).
  6. ${BOLD("DNS CNAME")} from your custom domain → the distribution's
     ${DIM("*.cloudfront.net")} hostname.
  7. ${BOLD("Three lifecycle rules")} on the bucket with tag filters
     ${DIM("expire-days=1")}, ${DIM("expire-days=7")}, ${DIM("expire-days=30")} expiring after the
     matching number of days.

The README has step-by-step screenshots / examples. If any of the above
isn't done yet, hit Ctrl+C now, set it up, and come back.

`);
}

async function askPath() {
  const ready = await confirm({ message: "Ready to continue?", default: true });
  if (!ready) {
    process.stdout.write(
      "\nCancelled. Re-run `dropgallery --setup` when you're ready.\n",
    );
    process.exit(0);
  }
}

function validateRequired(value) {
  if (!value || !value.trim()) return "This is required.";
  return true;
}

async function ask4Values() {
  const awsProfile = await input({
    message: "AWS profile name (in ~/.aws/credentials):",
    default: "gallery",
  });
  const awsRegion = await input({
    message: "AWS region:",
    default: "us-east-1",
  });
  const s3Bucket = await input({
    message: "S3 bucket name:",
    validate: validateRequired,
  });
  const cloudfrontDomain = await input({
    message: "CloudFront domain (e.g. gallery.yourdomain.com — no scheme):",
    validate: validateRequired,
  });
  return {
    awsProfile: awsProfile.trim(),
    awsRegion: awsRegion.trim(),
    s3Bucket: s3Bucket.trim(),
    cloudfrontDomain: cloudfrontDomain
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, ""),
  };
}

// PutObject + a tag exercises both s3:PutObject and s3:PutObjectTagging in
// one round-trip. HeadBucket would have needed s3:ListBucket, which isn't in
// the documented minimum policy. The test object is tagged expire-days=1
// so the lifecycle rule (if configured) will clean it up; we also attempt
// a DeleteObject — failure there is fine, that permission isn't required.
async function validateBucket({ awsProfile, awsRegion, s3Bucket }) {
  const client = new S3Client({
    region: awsRegion,
    credentials: fromIni({ profile: awsProfile }),
  });
  const testKey = `_dropgallery_setup_check_${randomBytes(6).toString("hex")}`;
  await client.send(
    new PutObjectCommand({
      Bucket: s3Bucket,
      Key: testKey,
      Body: "DropGallery setup check\n",
      ContentType: "text/plain; charset=utf-8",
      Tagging: "expire-days=1",
    }),
  );
  // Best-effort cleanup; lifecycle handles it within a day if delete fails.
  try {
    await client.send(
      new DeleteObjectCommand({ Bucket: s3Bucket, Key: testKey }),
    );
  } catch (_e) {
    /* ignore — test object will auto-expire */
  }
  return client;
}

async function checkLifecycle(client, bucket) {
  try {
    const out = await client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
    );
    const rules = out.Rules || [];
    const wanted = new Set(["1", "7", "30"]);
    const found = new Set();
    for (const rule of rules) {
      const tags =
        (rule.Filter && rule.Filter.Tag ? [rule.Filter.Tag] : null) ||
        (rule.Filter && rule.Filter.And && rule.Filter.And.Tags) ||
        [];
      for (const tag of tags) {
        if (tag.Key === "expire-days" && wanted.has(String(tag.Value))) {
          found.add(String(tag.Value));
        }
      }
    }
    const missing = ["1", "7", "30"].filter((d) => !found.has(d));
    if (missing.length === 0) {
      process.stdout.write(
        `  ${TICK} all three lifecycle rules present (expire-days=1/7/30)\n`,
      );
    } else {
      process.stdout.write(
        `  ${WARN} missing lifecycle rule(s) for expire-days=${missing.join(",")}.\n` +
          `    Galleries with that expiration won't auto-delete. See README §3.\n`,
      );
    }
  } catch (err) {
    if (
      err.name === "NoSuchLifecycleConfiguration" ||
      err.Code === "NoSuchLifecycleConfiguration"
    ) {
      process.stdout.write(
        `  ${WARN} no lifecycle rules found on this bucket.\n` +
          `    Galleries set to expire (1/7/30 days) won't actually auto-delete.\n` +
          `    See README §3 for the three rules to create.\n`,
      );
    } else if (err.name === "AccessDenied" || err.Code === "AccessDenied") {
      // s3:GetLifecycleConfiguration isn't in the minimum policy — stay quiet.
    } else {
      process.stdout.write(
        `  ${WARN} couldn't check lifecycle rules: ${err.message}\n`,
      );
    }
  }
}

function explainAuthError(err, awsProfile, s3Bucket) {
  const name = err.name || err.Code || "";
  if (name === "CredentialsProviderError" || /credentials/i.test(err.message)) {
    return (
      `Couldn't load credentials for profile "${awsProfile}".\n` +
      `Run: aws configure --profile ${awsProfile}\n` +
      `…or check ~/.aws/credentials has a [${awsProfile}] section.`
    );
  }
  if (name === "NoSuchBucket") {
    return `Bucket "${s3Bucket}" doesn't exist. Check the name (and that you're using the AWS account this profile belongs to).`;
  }
  if (
    name === "PermanentRedirect" ||
    /permanent.*redirect/i.test(err.message)
  ) {
    return (
      `Bucket "${s3Bucket}" exists but is in a different region than configured.\n` +
      `The error usually says where it actually lives — re-run setup with the right region.`
    );
  }
  if (
    name === "AccessDenied" ||
    name === "Forbidden" ||
    err.$metadata?.httpStatusCode === 403
  ) {
    return (
      `Profile "${awsProfile}" reached AWS but the bucket "${s3Bucket}" rejected the upload.\n` +
      `Verify the IAM policy grants s3:PutObject AND s3:PutObjectTagging on the bucket,\n` +
      `and that the bucket policy / Block Public Access settings don't deny the principal.`
    );
  }
  return `${name || "Error"}: ${err.message}`;
}

// Section order follows insertion order, so overwriting a destination keeps
// its position in the file rather than reshuffling.
function formatConfigFile(sections) {
  const header =
    `# DropGallery config — generated by \`dropgallery --setup\`\n` +
    `# Edit by hand or re-run --setup any time. Each [section] is one\n` +
    `# destination; pick at upload time with \`--target <name>\`.\n\n`;
  return header + ini.stringify(sections);
}

function destToRaw({ awsProfile, awsRegion, s3Bucket, cloudfrontDomain }) {
  return {
    AWS_PROFILE: awsProfile,
    AWS_REGION: awsRegion,
    S3_BUCKET: s3Bucket,
    CLOUDFRONT_DOMAIN: cloudfrontDomain,
  };
}

// Decide which destination this run edits, given any --as flag and what's
// already on disk:
//   --as <name>          → operate on that name (add or replace)
//   none, no config      → write [default]
//   none, one existing   → overwrite that one (any name)
//   none, multiple       → prompt "edit which? / new"
// If the chosen name already exists, confirm overwrite of just that section.
async function resolveWriteContext(targetName) {
  const writeTarget = configLookupPath();
  let existing = {};
  let parseError = null;
  if (existsSync(writeTarget)) {
    try {
      existing = loadConfigs().destinations;
    } catch (err) {
      // Unparseable file — confirm overwrite below; user may want to salvage.
      parseError = err;
    }
  }

  if (parseError) {
    process.stdout.write(
      `\n${WARN} Existing config at ${writeTarget} couldn't be parsed:\n` +
        `   ${parseError.message}\n` +
        `   Continuing will replace the file. Other content in it (comments,\n` +
        `   manual edits) will be lost.\n\n`,
    );
    const ok = await confirm({
      message: "Replace the unparseable config?",
      default: false,
    });
    if (!ok) {
      process.stdout.write("\nCancelled. Config left as-is.\n");
      process.exit(0);
    }
    // Proceed with no existing destinations.
    existing = {};
  }

  const existingNames = Object.keys(existing);

  let editName = targetName;
  if (!editName) {
    if (existingNames.length === 0) {
      editName = DEFAULT_NAME;
    } else if (existingNames.length === 1) {
      editName = existingNames[0];
    } else {
      const picked = await select({
        message: "Which destination do you want to set up?",
        choices: [
          ...existingNames.map((n) => ({ name: `Edit "${n}"`, value: n })),
          { name: "+ Add a new destination", value: ADD_NEW },
        ],
      });
      if (picked === ADD_NEW) {
        const name = await input({
          message: "New destination name:",
          validate: (v) => {
            const t = (v || "").trim();
            if (!t) return "Name is required.";
            if (!NAME_RE.test(t)) {
              return "Use letters, digits, dashes, or underscores.";
            }
            if (existing[t]) return `"${t}" already exists.`;
            return true;
          },
        });
        editName = name.trim();
      } else {
        editName = picked;
      }
    }
  } else if (!NAME_RE.test(editName)) {
    process.stdout.write(
      `\n${CROSS} Invalid destination name "${editName}" — use letters, digits, dashes, or underscores.\n`,
    );
    process.exit(2);
  }

  const willReplace = !!existing[editName];
  if (willReplace) {
    const isDotfile = writeTarget === HOME_CONFIG_PATH;
    process.stdout.write(
      `\n${WARN} Destination "${editName}" already exists in ${writeTarget}\n`,
    );
    if (isDotfile) {
      process.stdout.write(
        `   (This dotfile takes priority over ${CONFIG_PATH}, so it's the active config.)\n`,
      );
    }
    process.stdout.write(
      `   Continuing will overwrite the [${editName}] section. Other destinations are untouched.\n\n`,
    );
    const ok = await confirm({
      message: `Overwrite [${editName}]?`,
      default: false,
    });
    if (!ok) {
      process.stdout.write(
        `\nCancelled. [${editName}] left as-is.\n`,
      );
      process.exit(0);
    }
  }

  return { writeTarget, existing, editName, willReplace };
}

// Inquirer's cancel signals (Ctrl+C, EOF, programmatic cancel).
function isInquirerCancel(err) {
  const name = err && err.constructor && err.constructor.name;
  return name === "ExitPromptError" || name === "CancelPromptError";
}

export async function runSetup({ targetName } = {}) {
  try {
    printPreamble();

    // Decide which section we're editing before walking the prompts; we also
    // need the other destinations so we can preserve them on write.
    const { writeTarget, existing, editName, willReplace } =
      await resolveWriteContext(targetName);

    process.stdout.write(
      `\nSetting up destination ${BOLD(`[${editName}]`)}` +
        (willReplace ? " (overwriting existing)" : "") +
        ".\n",
    );

    await askPath();

    const cfg = await ask4Values();

    process.stdout.write(
      `\nValidating against AWS (writing a tagged test object)…\n`,
    );
    let client;
    try {
      client = await validateBucket(cfg);
      process.stdout.write(
        `  ${TICK} PutObject + PutObjectTagging succeeded on bucket "${cfg.s3Bucket}"\n`,
      );
    } catch (err) {
      process.stdout.write(
        `  ${CROSS} ${explainAuthError(err, cfg.awsProfile, cfg.s3Bucket)}\n\n`,
      );
      process.stdout.write(
        "No config written. Fix the above and re-run `dropgallery --setup`.\n",
      );
      process.exit(1);
    }

    await checkLifecycle(client, cfg.s3Bucket);

    // Preserve other destinations; overlay the edited one.
    const merged = {};
    for (const [name, dest] of Object.entries(existing)) {
      merged[name] = destToRaw(dest);
    }
    merged[editName] = destToRaw(cfg);

    mkdirSync(dirname(writeTarget), { recursive: true });
    writeFileSync(writeTarget, formatConfigFile(merged), { mode: 0o600 });

    const otherNames = Object.keys(merged).filter((n) => n !== editName);
    process.stdout.write(
      `\n${TICK} Wrote [${editName}] to ${writeTarget}\n` +
        (otherNames.length > 0
          ? `  ${DIM(`Preserved: ${otherNames.map((n) => `[${n}]`).join(", ")}`)}\n`
          : "") +
        `\nYou're set. Try:\n` +
        `  ${DIM(
          otherNames.length > 0
            ? `dropgallery --target ${editName} /path/to/photo.jpg`
            : `dropgallery /path/to/photo.jpg /path/to/clip.mov`,
        )}\n\n` +
        `Or invoke via the Apple Shortcut documented in the README.\n`,
    );
  } catch (err) {
    if (isInquirerCancel(err)) {
      process.stdout.write("\nCancelled. No config written.\n");
      process.exit(0);
    }
    throw err;
  }
}
