# Third-Party Notices

Cherry Blossom Editor's own source is licensed under the AGPL-3.0-or-later — see
[LICENSE](LICENSE). It also bundles and builds on open source software owned by
others. This file carries the attribution those licenses require; it is a legal
notice, not an endorsement or a statement of affiliation.

The MIT, ISC, and Apache-2.0 terms these dependencies use are compatible with
the AGPL-3.0, so they combine into this distribution without conflict.

## Attribution required by the MIT License

The following upstream projects are distributed under the MIT License, which
requires their copyright notice to be reproduced in any distribution that
includes them:

- **tscircuit** and its ecosystem — Copyright (c) tscircuit contributors.
  <https://github.com/tscircuit/tscircuit>. Covers the `@tscircuit/*`,
  `circuit-json*`, `circuit-to-*`, `schematic-symbols`, and `kicad*` packages
  listed in `package.json`.
- **React** — Copyright (c) Meta Platforms, Inc. and affiliates.
  <https://github.com/facebook/react>

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Other dependencies

Every remaining runtime dependency is listed in `package.json` and installed
from npm, each under its own license (predominantly MIT, ISC, or Apache-2.0).
For the current breakdown of an installed tree:

```bash
npx license-checker --summary
```

Trademarks referenced here belong to their respective owners. Their use in this
file is for attribution only.
