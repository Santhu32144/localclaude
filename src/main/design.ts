// Design space: Claude's instructions for a design, and the script that lets you comment on
// an element of the design on the canvas (the page runs in a sandboxed frame, so it talks by postMessage).
import type { DesignInfo, DesignKind } from '../shared/types'

const KIND_GUIDE: Record<DesignKind, string> = {
  prototype: `This is an interactive prototype. Start with the main screen and make what's on it work like the real product (buttons, tabs, menus, a modal, a form that responds), with fake data and in-memory state. Build other screens when the user asks for them; then switch screens with a little JavaScript, and keep the first screen visible without it. Make it responsive: it must work at 1440px, 834px and 390px wide. For a mobile app, center a phone-sized layout on wider screens.`,
  slides: `This is a slide deck. Make each slide a <section class="slide"> exactly 1920×1080 px, stacked vertically with a 40px gap on a neutral background, so the canvas shows the deck as one scrolling page. Add print CSS so every slide becomes one PDF page: @page { size: 1920px 1080px; margin: 0 }, and in @media print remove the gap and the page background and give .slide { break-after: page }. Use a consistent master layout (title slide, section headers, content slides, a closing slide), large type (body text at least 28px), one idea per slide, charts drawn with inline SVG or CSS where numbers matter, and slide numbers.`,
  wireframe: `This is a wireframe, low fidelity on purpose: grayscale only, simple boxes and lines, image placeholders (a box with a cross), real but short labels, and a plain system font. Focus on layout, hierarchy and flow rather than polish. For several screens, lay them out side by side, each in a labeled frame, with short notes on the key interactions.`,
  onepager: `This is a printable page, like a one-pager, flyer, poster, résumé or report page. Design it as an A4 page (794×1123 px), or US Letter (816×1056 px) if the user asks for it, centered on a neutral background with a soft shadow. Add print CSS so it exports as exactly one PDF page with its background: @page { size: A4; margin: 0 } (or letter), and in @media print remove the surrounding margin, background and shadow.`,
  other: `Choose the format that fits the request (a landing page, poster, social media graphic, email, logo, icon set, …) and size the layout for it. Show a fixed-size graphic as an artboard at its real pixel size, centered on a neutral background.`
}

/** Instructions added to Claude's system prompt in a design. */
export function designPrompt(design: DesignInfo, cwd: string): string {
  const lines = [
    `<design kind="${design.kind}">`,
    `This chat is a design in LocalClaude's Design space. The user sees your work on a large canvas beside this chat (not in a side panel). They can view it at desktop, tablet and mobile widths, click any element to comment on it, go back to earlier versions, and export it as HTML, PDF or PNG.`,
    ``,
    `How to work (the user is watching, so speed matters):`,
    `- Start writing the design right away. No to-do list, no exploring files${design.matchStyle ? ' beyond the style check below' : ''}, and keep your planning short.`,
    `- Write the whole first version in ONE create_artifact call of type "html": a complete, self-contained page with its CSS in a <style> in the head, then the content from top to bottom, then any JavaScript in one <script> at the end. The canvas shows the page live as you write it. Never write a skeleton to fill in later, and never split one version over several calls. Fonts, icons and libraries may load from public CDNs (Google Fonts, cdnjs, jsDelivr, unpkg). Use type "react" only if the user asks for it.`,
    `- Keep the first version focused, about 250 to 450 lines: the main screen or page, done well. Add more when the user asks. Never embed base64 images or long data.`,
    `- All content must be visible without JavaScript: don't hide sections until a script runs (no fade-in-on-scroll that starts invisible, no content rendered only by JS). Use JavaScript for interaction only.`,
    `- Make the first version straight away from what the user described. Ask first only if the request is truly unclear; otherwise make sensible choices and mention the main ones briefly.`,
    `- For changes, keep the same artifact id and use update_artifact with old_str/new_str, one small replacement per call, instead of rewriting the page; rewrite with content only when most of the page changes. Every change becomes a version the user can go back to. Create another artifact only when the user asks for alternatives to compare.`,
    `- Make it look finished and intentional: real, specific content (never lorem ipsum), a clear type hierarchy, consistent spacing on a 4/8px grid, a restrained palette with one accent color, accessible contrast, and hover, focus and active states for anything interactive. Use inline SVG, CSS shapes and gradients for illustrations and icons; use photos only from a stable URL (such as images.unsplash.com) and never leave a broken image.`,
    `- When the user comments on an element, their message gives its CSS selector, its text and the start of its HTML. Change that element as asked (usually with update_artifact old_str/new_str) and keep the rest of the design as it is.`,
    `- The design lives in the artifact: don't create or edit files in the working folder unless the user asks you to.`,
    `- Reply in a sentence or two: what you made or changed, and perhaps one or two ideas for next steps. Don't paste the code into the chat.`,
    ``,
    KIND_GUIDE[design.kind] ?? KIND_GUIDE.other
  ]
  if (design.matchStyle)
    lines.push(
      ``,
      `Match the product in the working folder (${cwd}). Before designing, take a quick look (a handful of files, found with Glob or Grep) at its design system: theme tokens and CSS variables, Tailwind or other style config, global styles, the component library, fonts, and the logo. Use the same colors, type, radii, spacing and component patterns (copy small SVG logos and icons inline), and say in a line what you based the design on.`
    )
  lines.push('</design>')
  return lines.join('\n')
}

/**
 * Comment mode for the design canvas. The canvas turns it on with {__lcDesign: 'comment', on};
 * hovering outlines elements, and a click picks one ({__lcDesignPick}) instead of reaching the page.
 * {__lcDesign: 'release'} lets go of the picked element when the comment box closes.
 */
const DESIGN_BRIDGE = `<script>(function(){
var on=false,held=null,box=null;
function ok(s){return /^[A-Za-z][\\w-]*$/.test(s)}
function cssPath(el){var parts=[];while(el&&el.nodeType===1&&el!==document.documentElement&&parts.length<6){if(el.id&&ok(el.id)){parts.unshift('#'+el.id);break}var tag=el.tagName.toLowerCase();if(tag==='body'){parts.unshift('body');break}var s=tag,cls=[].slice.call(el.classList).filter(ok).slice(0,2);if(cls.length)s+='.'+cls.join('.');var p=el.parentElement;if(p){var same=[].filter.call(p.children,function(c){return c.tagName===el.tagName});if(same.length>1)s+=':nth-of-type('+(same.indexOf(el)+1)+')'}parts.unshift(s);el=p}return parts.join(' > ')}
function show(el){if(!box){box=document.createElement('div');box.style.cssText='position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #d97757;background:rgba(217,119,87,.1);border-radius:3px;box-sizing:border-box';document.documentElement.appendChild(box)}var r=el.getBoundingClientRect();box.style.display='block';box.style.left=r.left+'px';box.style.top=r.top+'px';box.style.width=r.width+'px';box.style.height=r.height+'px'}
function hide(){if(box)box.style.display='none'}
function mode(v){on=v;held=null;document.documentElement.style.cursor=v?'crosshair':'';if(!v)hide()}
window.addEventListener('message',function(e){var d=e.data;if(e.source!==parent||!d)return;if(d.__lcDesign==='comment')mode(!!d.on);else if(d.__lcDesign==='release'){held=null;hide()}});
document.addEventListener('mousemove',function(e){if(on&&!held&&e.target&&e.target.nodeType===1)show(e.target)},true);
document.addEventListener('mouseleave',function(){if(on&&!held)hide()});
window.addEventListener('scroll',function(){if(held)show(held)},true);
['mousedown','mouseup','pointerdown','pointerup','dblclick','submit','contextmenu'].forEach(function(t){document.addEventListener(t,function(e){if(on){e.preventDefault();e.stopPropagation()}},true)});
document.addEventListener('click',function(e){if(!on)return;e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();var el=e.target;if(!el||el.nodeType!==1)return;held=el;show(el);var r=el.getBoundingClientRect();
parent.postMessage({__lcDesignPick:{selector:cssPath(el),tag:el.tagName.toLowerCase(),text:(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,160),html:el.outerHTML.slice(0,400),rect:{x:r.left,y:r.top,w:r.width,h:r.height}}},'*')},true);
document.addEventListener('keydown',function(e){if(on&&e.key==='Escape')parent.postMessage({__lcDesignKey:'Escape'},'*')},true);
})()</script>`

/**
 * The page the canvas shows while Claude is still writing a design (artifact://draft/). The canvas posts
 * the HTML so far ({__lcDraft}); it's parsed without running scripts (a half-written script can't run,
 * and the finished design replaces this page), and the view follows the newest part unless you scroll up.
 */
export const DRAFT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#fff}</style></head><body><script>(function(){
var head=null,follow=true;
addEventListener('wheel',function(e){if(e.deltaY<0)follow=false},{passive:true});
addEventListener('message',function(e){var d=e.data;if(e.source!==parent||!d||typeof d.__lcDraft!=='string')return;
var html=d.__lcDraft.replace(/<script\\b[\\s\\S]*?(?:<\\/script\\s*>|$)/gi,'');
var doc=new DOMParser().parseFromString(html,'text/html'),root=document.documentElement;
[].slice.call(root.attributes).forEach(function(a){root.removeAttribute(a.name)});
[].slice.call(doc.documentElement.attributes).forEach(function(a){root.setAttribute(a.name,a.value)});
if(doc.head.innerHTML!==head){head=doc.head.innerHTML;document.head.innerHTML=head}
document.body.replaceWith(document.adoptNode(doc.body));
if(follow)scrollTo(0,root.scrollHeight)});
})()</script></body></html>`

/** The preview page with comment mode added (the canvas loads previews with ?design=1). */
export function withDesignBridge(page: string): string {
  const i = page.toLowerCase().lastIndexOf('</body>')
  return i >= 0 ? page.slice(0, i) + DESIGN_BRIDGE + page.slice(i) : page + DESIGN_BRIDGE
}
