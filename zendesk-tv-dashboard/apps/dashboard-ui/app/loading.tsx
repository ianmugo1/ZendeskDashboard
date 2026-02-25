import Image from "next/image";
import type { ReactElement } from "react";

export default function Loading(): ReactElement {
  return (
    <main className="splash-screen">
      <div className="splash-card">
        <Image
          src="/emerald-park-logo.png"
          alt="Emerald Park"
          width={220}
          height={220}
          priority
          className="splash-logo"
        />
        <p className="splash-subtitle">Emerald Park IT Ticket Dashboard</p>
        <div className="splash-loader" aria-hidden="true" />
        <div className="splash-progress" aria-hidden="true">
          <span className="splash-progress-fill" />
        </div>
      </div>
    </main>
  );
}
