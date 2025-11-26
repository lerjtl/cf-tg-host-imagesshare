import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { useInView } from "react-intersection-observer";
import Masonry from "react-masonry-css";
import { listFiles, logout } from "../lib/api";
import Toast from "../components/Toast";

export default function Gallery() {
  const nav = useNavigate();
  const [items, setItems] = React.useState<{
    id: string;
    mime?: string;
    thumbnailId?: string;
  }[]>([]);
  const [cursor, setCursor] = React.useState<string>("");
  const [hasMore, setHasMore] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [initialized, setInitialized] = React.useState(false);
  const [msg, setMsg] = React.useState("");
  const [toast, setToast] = React.useState<{
    message: string;
    type?: "info" | "success" | "error";
  } | null>(null);
  const { ref: sentinelRef, inView } = useInView({
    threshold: 0,
    rootMargin: "200px 0px",
  });

  // 监听删除事件，移除对应项并提示
  React.useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { id?: string };
      if (!detail?.id) return;
      setItems((prev) => prev.filter((x) => x.id !== detail.id));
      setToast({ message: "已删除并清理缓存", type: "success" });
    };
    window.addEventListener("gallery:removed", handler as EventListener);
    return () =>
      window.removeEventListener("gallery:removed", handler as EventListener);
  }, []);

  const load = React.useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setMsg("");
    try {
      const data = await listFiles({ limit: 10, cursor });
      const ids = (data.keys || [])
        .map((k: any) => ({ id: k.id, mime: k.mime, thumbnailId: k.thumbnailId }))
        .filter(Boolean);
      // 直接追加，由服务端 cursor 保证不重复
      setItems((prev) => prev.concat(ids));
      // 更稳健的 hasMore 判定，要求存在有效 cursor 且服务端声明未完成
      setHasMore(Boolean(data.cursor) && data.list_complete === false);
      setCursor(data.cursor || "");
    } catch (err: any) {
      setMsg(err?.message || "加载失败");
    } finally {
      setInitialized(true);
      setLoading(false);
    }
  }, [cursor, loading]);

  React.useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 使用 react-intersection-observer 自动加载更多
  React.useEffect(() => {
    if (inView && initialized && hasMore && !loading) {
      load();
    }
  }, [inView, initialized, hasMore, loading, load]);

  const copyLink = async (id: string) => {
    const url = `${location.origin}/file/${id}`;
    await navigator.clipboard.writeText(url);
    setToast({ message: "已复制链接", type: "success" });
  };

  return (
    <div className="min-h-svh bg-gray-50 text-gray-900">
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}
      {/* 浮动操作区：上传 / 退出登录 */}
      <div className="fixed top-4 right-4 z-40">
        <div className="flex items-center gap-2 bg-white/90 backdrop-blur border border-gray-200 rounded-full px-2 py-1 shadow-sm">
          <Link
            to="/"
            aria-label="上传"
            title="上传"
            className="inline-flex items-center justify-center h-8 w-8 rounded-full hover:bg-gray-50 text-gray-700"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="h-5 w-5"
            >
              <path
                d="M12 16V4"
                strokeLinecap="round"
                strokeLinejoin="round"
              ></path>
              <path
                d="M7 9l5-5 5 5"
                strokeLinecap="round"
                strokeLinejoin="round"
              ></path>
              <path
                d="M4 20h16"
                strokeLinecap="round"
                strokeLinejoin="round"
              ></path>
            </svg>
          </Link>
          <button
            onClick={async () => {
              await logout();
              nav("/login", { replace: true });
            }}
            aria-label="退出登录"
            title="退出登录"
            className="inline-flex items-center justify-center h-8 w-8 rounded-full text-gray-700 hover:bg-gray-50"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="h-5 w-5"
            >
              <path
                d="M9 4h-3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3"
                strokeLinecap="round"
                strokeLinejoin="round"
              ></path>
              <path
                d="M16 7l5 5-5 5"
                strokeLinecap="round"
                strokeLinejoin="round"
              ></path>
              <path
                d="M21 12H9"
                strokeLinecap="round"
                strokeLinejoin="round"
              ></path>
            </svg>
          </button>
        </div>
      </div>

      <main className="min-h-svh max-w-7xl mx-auto px-5 py-16">
        {msg && <div className="mb-3 text-sm text-red-500">{msg}</div>}

        {items.length === 0 && initialized ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="mb-4 p-4 rounded-full bg-gray-100">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="h-8 w-8 text-gray-400"
              >
                <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                <circle cx="9" cy="9" r="2" />
                <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
              </svg>
            </div>
            <h3 className="text-lg font-medium text-gray-900 mb-2">暂无图片</h3>
            <p className="text-gray-500 mb-4 max-w-sm">
              还没有上传任何图片，点击右上角的上传按钮开始使用吧
            </p>
            <Link
              to="/"
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="h-4 w-4"
              >
                <path
                  d="M12 16V4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M8 8l4-4 4 4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M3 15v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              上传图片
            </Link>
          </div>
        ) : (
          <Masonry
            breakpointCols={{
              default: 6,
              1536: 6,
              1280: 5,
              1024: 4,
              768: 3,
              640: 2,
              350: 1,
            }}
            className="flex w-auto -ml-5"
            columnClassName="pl-5 bg-clip-padding"
          >
            {items.map((item) => (
              <ImageItem key={item.id} item={item} onCopyLink={() => copyLink(item.id)} />
            ))}
          </Masonry>
        )}

        {/* 加载更多指示器 */}
        {hasMore && (
          <div className="mt-8">
            <div ref={sentinelRef} className="h-px w-full" />
            {loading && (
              <div className="flex items-center justify-center py-8">
                <div className="inline-flex items-center gap-2 text-gray-500">
                  <div
                    className="h-4 w-4 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin"
                    aria-label="loading more"
                  />
                  <span className="text-sm">加载更多...</span>
                </div>
              </div>
            )}
          </div>
        )}
        
        {/* 没有更多数据时的提示 */}
        {!hasMore && items.length > 0 && (
          <div className="mt-8 text-center">
            <div className="text-sm text-gray-400">已加载全部内容</div>
          </div>
        )}
      </main>
    </div>
  );
}

function ImageItem({ item, onCopyLink }: { item: { id: string; mime?: string; thumbnailId?: string; }; onCopyLink: () => void }) {
  const [mediaLoaded, setMediaLoaded] = React.useState(false);
  const [mediaError, setMediaError] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (deleting) return;
    const ok = window.confirm("确定删除该文件吗？此操作不可恢复");
    if (!ok) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
        credentials: "include"
      });
      if (!res.ok) throw new Error("删除失败");
      // 触发外层移除：通过自定义事件广播
      window.dispatchEvent(
        new CustomEvent("gallery:removed", { detail: { id: item.id } })
      );
    } catch (err: any) {
      // 失败仅提示
      alert(err?.message || "删除失败");
    } finally {
      setDeleting(false);
    }
  };
  const handleMediaLoad = () => {
    setMediaLoaded(true);
  };

  const handleMediaError = () => {
    setMediaError(true);
    setMediaLoaded(true);
  };

  const isVideo = item.mime?.startsWith('video/');
  const mediaUrl = `/file/${item.id}`;
  const thumbnailUrl = isVideo && item.thumbnailId ? `/file/${item.thumbnailId}?thumbnail=true` : undefined;

  return (
    <div className="mb-5 break-inside-avoid">
      <div className="bg-white rounded-lg overflow-hidden group border border-gray-200 shadow-sm relative">
        <div className="relative overflow-hidden w-full">
          {!mediaLoaded && !mediaError && (
            <div className="flex flex-col items-center justify-center w-full aspect-[3/4] bg-gray-50">
              <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mb-3"></div>
              <span className="text-sm text-gray-600 font-medium">加载中...</span>
            </div>
          )}
          {mediaError ? (
            <div className="flex flex-col items-center justify-center w-full aspect-[3/4] bg-gray-50">
              <svg className="w-10 h-10 mb-2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <span className="text-xs text-gray-500">加载失败</span>
            </div>
          ) : (
            <a href={mediaUrl} target="_blank" rel="noreferrer" className="block">
              {isVideo ? (
                <video
                  src={mediaUrl}
                  poster={thumbnailUrl} // Use the thumbnail for the poster
                  controls
                  preload="metadata"
                  onLoadedData={handleMediaLoad}
                  onError={handleMediaError}
                  className={`block w-full object-cover transition-opacity duration-300 ${
                    mediaLoaded ? "opacity-100" : "opacity-0"
                  }`}
                />
              ) : (
                <img
                  src={mediaUrl}
                  alt=""
                  onLoad={handleMediaLoad}
                  onError={handleMediaError}
                  loading="lazy"
                  className={`block w-full object-cover transition-opacity duration-300 ${
                    mediaLoaded ? "opacity-100" : "opacity-0"
                  }`}
                />
              )}
            </a>
          )}
        </div>
        {mediaLoaded && !mediaError && (
          <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200 bg-black/40">
            <button onClick={handleDelete} disabled={deleting} className="absolute top-2 right-2 h-8 px-2 text-xs rounded-md bg-rose-600 text-white shadow-sm hover:bg-rose-700 disabled:opacity-60">
              {deleting ? "删除中…" : "删除"}
            </button>
            <button onClick={onCopyLink} className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 h-8 px-3 text-xs rounded-full bg-white text-gray-900 shadow-md hover:bg-gray-50">
              复制链接
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
