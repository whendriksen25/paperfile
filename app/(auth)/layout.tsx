"use client";

import Image from "next/image";
import { useState } from "react";
import { Wordmark } from "@/components/brand/logo";

function AuthBrand() {
  const [failed, setFailed] = useState(false);
  if (failed) return <Wordmark />;
  return (
    <Image
      src="/brand/paperfile-logo.png"
      alt="Paperfile"
      width={220}
      height={64}
      priority
      className="h-14 w-auto"
      onError={() => setFailed(true)}
    />
  );
}

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center px-6 py-12 bg-background bg-brand-gradient-soft">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-8">
          <AuthBrand />
        </div>
        {children}
      </div>
    </div>
  );
}
