export function Footer() {
  return (
    <footer className="mx-auto max-w-5xl px-6 pb-12 pt-20">
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-border pt-8">
        <div className="text-center sm:text-left">
          <a href="https://desplega.sh" className="text-sm font-medium text-foreground/70 hover:text-neon transition-colors">Desplega Labs</a>
          <p className="text-xs text-muted-foreground mt-0.5 italic">Made by builders, for builders.</p>
        </div>
        <p className="text-xs text-muted-foreground/50">
          &copy; 2026 Desplega Labs. All rights reserved.
        </p>
      </div>
    </footer>
  )
}
