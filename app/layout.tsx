import type { Metadata } from "next";
import { Zen_Maru_Gothic } from "next/font/google";
import { GoogleAnalytics } from "@next/third-parties/google";
import "./globals.css";

const zenMaru = Zen_Maru_Gothic({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["700", "900"],
});

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "ぷるぷらす",
  description:
    "パズル、無料、ブラウザ、オンライン対戦！数字を合体してゴールを目指そう。「ぷるぷらす」公式サイト。",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    title: "ぷるぷらす",
    description:
      "パズル、無料、ブラウザ、オンライン対戦！数字を合体してゴールを目指そう。「ぷるぷらす」公式サイト。",
    images: [
      {
        url: "/images/vs_online.png",
        width: 1200,
        height: 630,
        alt: "ぷるぷらす OGP",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "ぷるぷらす",
    description:
      "パズル、無料、ブラウザ、オンライン対戦！数字を合体してゴールを目指そう。「ぷるぷらす」公式サイト。",
    images: ["/images/vs_online.png"],
  },
  icons: {
    icon: [{ url: "/images/easy.png", type: "image/png" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body className={`${zenMaru.variable} min-h-[100dvh] antialiased`}>
        <div className="min-h-[100dvh]">
          {children}
          <div className="px-4 pb-[max(env(safe-area-inset-bottom),12px)] pt-2">
            <div className="mx-auto w-fit max-w-4xl rounded-full bg-white/70 px-4 py-2 text-center text-[11px] font-bold text-zinc-700/90 shadow-[0_14px_40px_rgba(120,70,40,.18)] backdrop-blur">
            このアプリ「ぷるぷらす」はGoogle Analyticsを使用しています。収集されたデータは利便性向上のためにのみ利用されます。
            </div>
          </div>
        </div>
        {process.env.NEXT_PUBLIC_GA_ID && <GoogleAnalytics gaId={process.env.NEXT_PUBLIC_GA_ID} />}
      </body>
    </html>
  );
}
