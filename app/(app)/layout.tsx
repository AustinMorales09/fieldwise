import Link from "next/link";
import { getUser } from "@/lib/auth";
import { logout } from "@/lib/actions";
import { db } from "@/lib/db";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  const waiting = user
    ? (db.prepare("SELECT COUNT(*) AS n FROM documents d JOIN orgs o ON o.id = d.org_id WHERE o.user_id = ? AND d.status = 'needs_review'").get(user.id) as { n: number }).n
    : 0;
  return (
    <>
      <nav className="nav">
        <Link href={user ? "/documents" : "/"} className="brand">Fieldwise</Link>
        <div className="nav-right">
          {user ? (
            <>
              <Link href="/documents">Documents{waiting ? <span className="count-badge">{waiting}</span> : null}</Link>
              <Link href="/templates">Templates</Link>
              <Link href="/integrations">Integrations</Link>
              <Link href="/settings">Settings</Link>
              <form action={logout}><button className="link">Log out</button></form>
            </>
          ) : (
            <>
              <Link href="/login">Log in</Link>
              <Link href="/signup">Sign up</Link>
            </>
          )}
        </div>
      </nav>
      {children}
    </>
  );
}
