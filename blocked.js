const params = new URLSearchParams(window.location.search);
const site = params.get("site") || "this site";
document.getElementById("siteName").textContent = site;
