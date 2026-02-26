import { randomInt } from "node:crypto";
import Image from "next/image";
import type { CSSProperties, ReactElement } from "react";

export default function Loading(): ReactElement {
  const splashSlides = ["/splash/After-Dark-1.jpg.webp", "/splash/CoasterDark.jpg", "/splash/FiannaForce.jpeg", "/splash/Walkway.jpg"];
  const startIndex = randomInt(splashSlides.length);
  const orderedSlides = splashSlides.map((_, index) => splashSlides[(startIndex + index) % splashSlides.length]);

  return (
    <main className="splash-screen">
      <div className="splash-bg" aria-hidden="true">
        {orderedSlides.map((slide, index) => (
          <span
            key={slide}
            className="splash-bg-slide"
            style={
              {
                "--splash-bg-image": `url('${slide}')`,
                "--splash-delay": `${index * 4}s`
              } as CSSProperties
            }
          />
        ))}
      </div>
      <div className="splash-tint" aria-hidden="true" />
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
        <div className="splash-loader-wrap" aria-hidden="true">
          <div className="splash-loader" />
        </div>
        <div className="splash-progress" aria-hidden="true">
          <span className="splash-progress-fill" />
        </div>
      </div>
      <p className="splash-credit" aria-hidden="true">
        Emerald Park Visuals
      </p>
    </main>
  );
}
