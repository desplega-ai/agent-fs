import { ViteReactSSG, type RouteRecord } from "vite-react-ssg"
import "@fontsource/space-grotesk/400.css"
import "@fontsource/space-grotesk/500.css"
import "@fontsource/space-grotesk/700.css"
import "@fontsource/jetbrains-mono/400.css"
import "./index.css"
import { AppLayout, DocDetailPage, HomePage } from "./App.tsx"
import { DOC_METADATA } from "@/content/doc-metadata"
import { DocsIndexPage } from "@/pages/DocsPage"

export const routes: RouteRecord[] = [
  {
    path: "/",
    element: <AppLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "docs", element: <DocsIndexPage /> },
    ],
  },
  {
    path: "/docs/:slug",
    element: <AppLayout wide />,
    children: [
      {
        index: true,
        element: <DocDetailPage />,
      },
    ],
    getStaticPaths: () => DOC_METADATA.map((doc) => `docs/${doc.slug}`),
  },
]

export const createRoot = ViteReactSSG({ routes, basename: import.meta.env.BASE_URL })
