import { Link } from "wouter";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-full w-full items-center justify-center px-4 py-16">
      <div className="max-w-sm text-center">
        <span className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-2xl border bg-card shadow-apple-md">
          <Compass className="h-6 w-6 text-muted-foreground" />
        </span>
        <p className="eyebrow">Error 404</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground lg:text-2xl">This page is off the map</h1>
        <p className="mt-2 text-sm text-muted-foreground">The address may be mistyped, or the page has moved.</p>
        <Link href="/">
          <Button className="mt-6">Back to the dashboard</Button>
        </Link>
      </div>
    </div>
  );
}
