import { Toaster as Sonner } from "sonner"

// Vendored shadcn `sonner` Toaster, trimmed to drop the next-themes dependency
// (not used in this app). Mount a single <Toaster /> near the app root.
type ToasterProps = React.ComponentProps<typeof Sonner>

function Toaster({ ...props }: ToasterProps) {
  return (
    <Sonner
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
