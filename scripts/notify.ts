#!/usr/bin/env tsx
// Admin CLI: send a push notification to one merchant or all of them.
//
// Usage:
//   npx tsx scripts/notify.ts --message "Hello merchants" [--title "Title"] \
//       [--instance shop1|all] [--url http://localhost:3000] [--token ADMIN_TOKEN]
//
// --token defaults to the ADMIN_TOKEN env variable.

interface Args {
  message?: string;
  title?: string;
  instance?: string;
  url: string;
  token?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { url: process.env.URL || 'http://localhost:3000' };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    switch (key) {
      case '--message': args.message = value; i++; break;
      case '--title': args.title = value; i++; break;
      case '--instance': args.instance = value; i++; break;
      case '--url': args.url = value; i++; break;
      case '--token': args.token = value; i++; break;
      case '--help':
        console.log('Usage: tsx scripts/notify.ts --message "..." [--title "..." ] [--instance name|all] [--url URL] [--token TOKEN]');
        process.exit(0);
      default:
        console.error(`Unknown argument: ${key}`);
        process.exit(1);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.message) {
    console.error('Error: --message is required');
    process.exit(1);
  }
  const token = args.token || process.env.ADMIN_TOKEN;
  if (!token) {
    console.error('Error: provide --token or set the ADMIN_TOKEN env variable');
    process.exit(1);
  }

  const body: Record<string, string> = { message: args.message };
  if (args.title) body.title = args.title;
  if (args.instance) body.instance = args.instance;

  const res = await fetch(`${args.url.replace(/\/$/, '')}/api/admin/notify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': token,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Error ${res.status}:`, data.message || res.statusText);
    process.exit(1);
  }
  console.log(`Notification sent to ${data.sent} subscription(s)`);
}

main().catch((e) => {
  console.error('Error:', e.message || e);
  process.exit(1);
});
