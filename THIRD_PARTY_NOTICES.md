# Third-party notices

Mailcove is distributed under the MIT License (see [LICENSE](LICENSE)). It builds on
open-source dependencies, and some UI code is generated into this repository rather than
installed as a package. Their licenses and copyright notices are retained below.

## Vendored UI components (shadcn/ui)

Some components under `app/components/` were generated using shadcn/ui, which is
distributed under the MIT License. shadcn/ui ships code into your project rather than as
a runtime dependency, so the notice is retained here.

```
MIT License
Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy of this
software and associated documentation files, to deal in the Software without
restriction, including the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies, subject to the inclusion of this notice. The Software
is provided "as is", without warranty of any kind.
```

## Runtime and build dependencies

The following packages are used at runtime or build time. Each is under its own license
(MIT unless noted in the package). See the respective package for full text.

- react, react-dom (MIT)
- @tanstack/react-query (MIT)
- radix-ui (MIT)
- lucide-react (ISC)
- cmdk (MIT)
- sonner (MIT)
- class-variance-authority (Apache-2.0)
- clsx, tailwind-merge (MIT)
- jose (MIT)
- postal-mime (MIT)
- @react-email/editor (MIT)
- vite, @vitejs/plugin-react (MIT)
- tailwindcss, @tailwindcss/vite (MIT)
- typescript (Apache-2.0)
- wrangler, @cloudflare/workers-types (MIT or Apache-2.0)
- vitest, jsdom, @testing-library/* (MIT)

## Verifying

Before a release, run a license check across the installed dependency tree, for example:

```bash
npx license-checker --summary
```

If any dependency is added under a license that is not compatible with MIT
redistribution, update this file or replace the dependency.
