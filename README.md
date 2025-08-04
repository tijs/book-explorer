# Book Explorer 📚

Book explorer is a very simple alternate UI for the
[Bookhive.buzz](https://bookhive.buzz) social platform for book lovers. This
tool allows you to edit the status of your bookhive collection books with a
simple dropdown per book, or by bulk editing multiple selected books at once.

The practical reason of making this was that i wanted to fix the read status for
a lot of books at once, but also try my hand at a full oauth implementation,
including editing of your own records, not just viewing.

But the more high-minded reason (which i came up with after the fact) is that it
shows off the power of atproto! I did not have to make an account for Bookhive,
i could just login with Bluesky, upload my books and go. And then because
bookhive stores my books on the atproto network as records i can make a tool to
fetch those same records from my own pds (in this case bsky.social but works for
any pds) and just edit them. And the changes show up in Bookhive! How cool is
that.

## How to use

### Quick Start on Val Town

1. **Remix this project** on [Val Town](https://val.town)
2. **Deploy it** - Val Town will provide you with a public URL
3. **Visit your app** and enter your Bluesky handle (e.g.,
   `yourname.bsky.social`)
4. **Authenticate** through the standard OAuth flow
5. **Manage your books** - view and update your reading status

That's it! No configuration or setup required.

### Local Development

```bash
# Clone the repository
git clone <your-repo-url>
cd book-explorer

# Run with Deno
deno task quality  # Format, lint, and type check
deno run --allow-net --allow-env backend/index.ts
```

## Technical Details

- **Frontend**: React with TypeScript
- **Backend**: Hono framework on Deno
- **Authentication**: OAuth 2.0 with DPoP (Demonstration of Proof-of-Possession)
- **Database**: SQLite for session storage
- **Protocol**: ATProto for decentralized data storage
- **Deployment**: Optimized for Val Town and Deno environments

## Architecture

Book Explorer implements a complete OAuth 2.0 flow for ATProto with:

- **Manual OAuth Implementation**: Built for Deno/Val Town compatibility
- **DPoP Token Binding**: Secure authentication without bearer token
  vulnerabilities
- **Session Persistence**: SQLite storage for OAuth sessions and DPoP keys
- **Direct API Integration**: Raw ATProto XRPC calls for maximum compatibility

## Made by

Created by **Tijs** ([@tijs.org](https://bsky.app/profile/tijs.org))

## License

MIT License - Feel free to fork, modify, and use this project for your own book
management needs.
