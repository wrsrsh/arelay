# Third-party notices

## OpenAI Codex model catalog

`vendor/codex-models.json` is derived from `codex-rs/models-manager/models.json`
in [openai/codex](https://github.com/openai/codex), revision
`90b67c96ca0e70e0beead6085db46d8beef934fe`.

Copyright OpenAI. Licensed under Apache License 2.0; see
`vendor/LICENSE.openai-codex` (distributed as `LICENSE.openai-codex`).

arelay uses this snapshot only when the user has no custom catalog. At setup,
arelay creates a modified copy: it normalizes tool/agent transport and adds a
Claude alias. User-supplied catalogs are preserved in the setup backup.

## Terminal setup dependencies

The bundled terminal UI includes the following MIT-licensed packages:

- `@clack/prompts` and `@clack/core`: Copyright (c) 2025-Present [Bombshell contributors](https://bomb.sh/team)
- `fast-string-width` and `fast-string-truncated-width`: Copyright (c) 2024-present Fabio Spampinato
- `fast-wrap-ansi`: Copyright (c) 2025 James Garbutt; Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)
- `sisteransi`: Copyright (c) 2018 Terkel Gjervig Nielsen

Their MIT permission and warranty terms follow:

```text
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

## smol-toml

The bundled TOML parser is [smol-toml](https://github.com/squirrelchat/smol-toml),
licensed under BSD-3-Clause. Exact version and integrity are recorded in
`pnpm-lock.yaml`.

```text
Copyright (c) Squirrel Chat et al., All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software without
   specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
