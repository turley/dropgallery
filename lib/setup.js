// Interactive `dropgallery --setup` wizard. Prints a preamble of what AWS bits
// the user needs ready, prompts for the four config values, validates by
// performing the same PutObject+Tagging the upload pipeline does (so it
// works with the documented minimum policy and catches the same kinds of
// failures), and writes the config to its OS-appropriate location.
//
// Setup is always CLI-mode regardless of platform (see gallery.js — it sets
// DROPGALLERY_UI=cli before importing this module). macOS GUI dialogs are
// awkward for multi-step instructional flows; a terminal wizard works the
// same everywhere.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { input, confirm } from "@inquirer/prompts";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
} from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-providers";
import { CONFIG_PATH, HOME_CONFIG_PATH, configLookupPath } from "./config.js";

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

// Validate by performing the actual operations the gallery upload pipeline
// needs: PutObject + a tag (which exercises both s3:PutObject AND
// s3:PutObjectTagging in one round-trip). HeadBucket would have required
// s3:ListBucket — a permission the documented minimum policy doesn't grant,
// so users with the strict minimum would fail validation despite having
// everything the tool actually needs.
//
// We intentionally tag the test object with `expire-days=1` so the lifecycle
// rule (if configured) cleans it up automatically within a day. We also try
// DeleteObject for an immediate cleanup; failure there is fine — it just
// means s3:DeleteObject isn't granted, which the gallery upload doesn't need.
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
  // Best-effort cleanup. Lifecycle rule with expire-days=1 will clean up
  // within a day if delete isn't permitted.
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
      // Reading lifecycle rules requires s3:GetLifecycleConfiguration, which
      // isn't in the documented minimum policy. Don't penalize users who
      // don't grant it — just stay quiet. The preamble already told them to
      // set up the rules.
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

function formatConfig({ awsProfile, awsRegion, s3Bucket, cloudfrontDomain }) {
  return (
    `# DropGallery config — generated by \`dropgallery --setup\`\n` +
    `# Edit by hand or re-run --setup any time.\n\n` +
    `AWS_PROFILE=${awsProfile}\n` +
    `AWS_REGION=${awsRegion}\n` +
    `S3_BUCKET=${s3Bucket}\n` +
    `CLOUDFRONT_DOMAIN=${cloudfrontDomain}\n`
  );
}

// If a config already exists, warn and confirm overwrite. Returns the path
// we'll write to: prefers `~/.galleryrc` if it exists (so re-running setup
// updates the file that's actually in use, not a shadowed one in the
// env-paths location), otherwise the env-paths location.
async function resolveWriteTarget() {
  const active = configLookupPath();
  if (!existsSync(active)) return active;

  const isDotfile = active === HOME_CONFIG_PATH;
  process.stdout.write(`\n${WARN} A config already exists at ${active}\n`);
  if (isDotfile) {
    process.stdout.write(
      `   (This dotfile takes priority over ${CONFIG_PATH}, so it's the active config.)\n`,
    );
  }
  process.stdout.write(`   Continuing will overwrite it with new values.\n\n`);

  const ok = await confirm({
    message: "Overwrite the existing config?",
    default: false,
  });
  if (!ok) {
    process.stdout.write("\nCancelled. Existing config left as-is.\n");
    process.exit(0);
  }
  return active;
}

// Inquirer rejects with ExitPromptError on Ctrl+C / EOF on stdin and with
// CancelPromptError if something programmatically cancels. Either way it's
// "user is done" — translate to a clean process exit with a friendly note.
function isInquirerCancel(err) {
  const name = err && err.constructor && err.constructor.name;
  return name === "ExitPromptError" || name === "CancelPromptError";
}

export async function runSetup() {
  try {
    printPreamble();

    // If there's already a config, warn + confirm overwrite BEFORE going
    // through the prompts again. The path we write to is the active one
    // (so re-running setup updates the file actually in use, not a shadow).
    const writeTarget = await resolveWriteTarget();

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

    mkdirSync(dirname(writeTarget), { recursive: true });
    writeFileSync(writeTarget, formatConfig(cfg), { mode: 0o600 });
    process.stdout.write(
      `\n${TICK} Wrote config to ${writeTarget}\n\n` +
        `You're set. Try:\n` +
        `  ${DIM("dropgallery /path/to/photo.jpg /path/to/clip.mov")}\n\n` +
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
