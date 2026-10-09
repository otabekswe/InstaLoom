"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Bookmark, Camera, Check, CheckCheck, Heart, MessageCircle, Paperclip, Pause, Play, RotateCcw, Send, Smile } from "lucide-react";
import styles from "./home-page.module.css";

const examples = [
  { label: "Direct messages", icon: Send, type: "dm", description: "Maya asks about a collection in a private conversation. A typing indicator leads into your reply and her thank-you." },
  { label: "Comments", icon: MessageCircle, type: "comments", description: "Leo comments on a ceramics post. Your public reply appears underneath his comment, with likes and a follow-up in the same thread." },
  { label: "Story replies", icon: Camera, type: "story", description: "Nina replies to your studio story. The original photo stays attached to her message as you reply privately." },
] as const;

export function InboxPreview() {
  const [selected, setSelected] = useState(0);
  const [replay, setReplay] = useState(0);
  const [animate, setAnimate] = useState(true);
  const [paused, setPaused] = useState(false);
  const previewRef = useRef<HTMLElement>(null);
  const example = examples[selected];

  useEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function scheduleNext() {
      clearTimeout(timer);
      if (paused || reducedMotion.matches || document.hidden || !visible) return;
      // Let the conversation finish, then hold before advancing.
      timer = setTimeout(() => {
        setAnimate(true);
        setSelected((current) => (current + 1) % examples.length);
      }, 6500);
    }

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting && entry.intersectionRatio >= 0.15;
      scheduleNext();
    }, { threshold: 0.15 });
    observer.observe(preview);
    reducedMotion.addEventListener("change", scheduleNext);
    document.addEventListener("visibilitychange", scheduleNext);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      reducedMotion.removeEventListener("change", scheduleNext);
      document.removeEventListener("visibilitychange", scheduleNext);
    };
  }, [paused, selected, replay]);

  return (
    <section ref={previewRef} className={styles.showcase} aria-label="Interactive inbox preview">
      <div className={styles.stage}>
        <div className={styles.window}>
          <div className={styles.windowToolbar}>
            <div><example.icon size={17} /><span>{example.label}</span></div>
            <div className={styles.previewTools}>
              <span>Preview</span>
              <button className={styles.replay} onClick={() => setPaused((value) => !value)} aria-label={paused ? "Play inbox preview" : "Pause inbox preview"} title={paused ? "Play preview" : "Pause preview"}>{paused ? <Play size={14} /> : <Pause size={14} />}</button>
              <button className={styles.replay} onClick={() => { setPaused(false); setAnimate(true); setReplay((value) => value + 1); }} aria-label="Replay inbox preview" title="Replay preview"><RotateCcw size={14} /></button>
            </div>
          </div>
          <div key={`${selected}-${replay}`} data-preview-type={example.type} data-animate={animate} data-paused={paused} className={styles.conversation} aria-hidden="true">
            {example.type === "dm" ? <DirectMessagePreview /> : example.type === "comments" ? <CommentsPreview /> : <StoryReplyPreview />}
          </div>
        </div>
      </div>
      <div className={styles.previewTabs} role="group" aria-label="Explore message types">
        {examples.map((item, index) => <button key={item.label} aria-pressed={selected === index} onClick={(event) => { setAnimate(event.detail !== 0 && !paused); if (event.detail === 0) setPaused(true); setSelected(index); setReplay((value) => value + 1); }} className={styles.previewTab}><item.icon size={15} /><span>{item.label}</span></button>)}
      </div>
      <p className="sr-only">{example.description} Select a message type to explore the preview. No real messages are sent.</p>
    </section>
  );
}

function DirectMessagePreview() {
  return <>
    <div className={styles.conversationHeader}>
      <div className={styles.avatar} data-color="lavender">MC</div>
      <div className={styles.person}><strong>Maya Chen</strong><span>Direct message</span></div>
      <div className={styles.completed}><Check size={15} /><span>Replied</span></div>
    </div>
    <div className={styles.messages}>
      <div className={styles.incoming}><p>Hi! Is the new collection available yet?</p><span className={styles.timestamp}>Just now</span></div>
      <div className={styles.responseArea}>
        <div className={styles.typing}><i /><i /><i /></div>
        <div className={styles.outgoing}><p>It’s here! I saved a few pieces for you.</p><span className={styles.sent}>Sent<CheckCheck size={13} /></span></div>
      </div>
      <div className={styles.followup}><p>You made my day. Thank you!</p><span className={styles.timestamp}>Just now</span></div>
    </div>
    <MessageComposer />
  </>;
}

function CommentsPreview() {
  return <>
    <div className={styles.postSummary}>
      <Image src="/images/studio-preview.webp" width={80} height={88} alt="" className={styles.postImage} />
      <div><strong>form.studio</strong><p>Fresh from the kiln.<br />A little olive for your everyday.</p><span>2 hours ago</span></div>
    </div>
    <div className={styles.postActions}><Heart size={16} /><span>128</span><MessageCircle size={16} /><span>12 comments</span><Bookmark size={16} /></div>
    <div className={styles.commentThread}>
      <div className={`${styles.commentRow} ${styles.commentOriginal}`}>
        <div className={styles.avatar} data-color="peach">LM</div>
        <div className={styles.commentText}><p><strong>leo.martin</strong> Love these. Is the olive cup available?</p><div className={styles.commentMeta}><span>2m</span><span>8 likes</span><span>Reply</span></div></div>
        <Heart size={13} />
      </div>
      <div className={styles.commentReplies}>
        <div className={`${styles.commentRow} ${styles.commentAnswer}`}>
          <div className={`${styles.avatar} ${styles.studioAvatar}`}>FS</div>
          <div className={styles.commentText}><p><strong>form.studio</strong> <span className={styles.mention}>@leo.martin</span> It is! Find the new collection in our bio.</p><div className={styles.commentMeta}><span>Just now</span><span>Reply</span></div></div>
          <Heart size={13} className={styles.commentLike} />
        </div>
        <div className={`${styles.commentRow} ${styles.commentFollowup}`}>
          <div className={styles.avatar} data-color="peach">LM</div>
          <div className={styles.commentText}><p><strong>leo.martin</strong> Found it. Thank you!</p><div className={styles.commentMeta}><span>Just now</span><span>Reply</span></div></div>
          <Heart size={13} />
        </div>
      </div>
    </div>
    <div className={styles.commentComposer}><div className={`${styles.avatar} ${styles.studioAvatar}`}>FS</div><span>Add a comment…</span><Smile size={17} /><strong>Post</strong></div>
  </>;
}

function StoryReplyPreview() {
  return <>
    <div className={styles.conversationHeader}>
      <div className={`${styles.avatar} ${styles.storyAvatar}`} data-color="sage">NP</div>
      <div className={styles.person}><strong>Nina Park</strong><span>Replied to your story</span></div>
      <Camera size={17} className={styles.storyCamera} />
    </div>
    <div className={`${styles.messages} ${styles.storyMessages}`}>
      <div className={styles.storyQuote}>
        <span className={styles.storyLabel}>Your story · 2h</span>
        <div className={styles.storyCard}>
          <Image src="/images/studio-preview.webp" fill sizes="120px" alt="" />
          <div className={styles.storyProgress}><i /><i /><i /></div>
          <span className={styles.storyCaption}>A little look inside.</span>
        </div>
      </div>
      <div className={styles.incoming}><p>This studio is a dream. Where is it?</p></div>
      <div className={styles.responseArea}>
        <div className={styles.typing}><i /><i /><i /></div>
        <div className={styles.outgoing}><p>Just around the corner.<br />Come say hello!</p><span className={styles.sent}>Sent<CheckCheck size={13} /></span></div>
      </div>
    </div>
    <MessageComposer />
  </>;
}

function MessageComposer() {
  return <div className={styles.composer}><Paperclip size={16} /><span>Write a reply…</span><span className={styles.sendIcon}><Send size={14} /></span></div>;
}
