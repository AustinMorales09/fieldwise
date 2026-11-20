import Link from "next/link";
import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";

export default async function Home() {
  if (await getUser()) redirect("/documents");
  return (
    <main className="hero">
      <h1>Stop retyping invoices</h1>
      <p>
        Upload PDFs, photos or scans. Fieldwise pulls out the fields you define, shows each value next to the document with
        the text it came from, and flags what looks wrong: totals that don&apos;t add up, missing fields, duplicates.
        Approve and export clean CSV.
      </p>
      <Link href="/signup" className="btn">Try it with sample documents</Link>
    </main>
  );
}
