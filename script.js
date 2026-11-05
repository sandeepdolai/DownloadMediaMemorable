const downloadForm = document.querySelector('#download-form');
const mediaUrl = document.querySelector('#media-url');
const feedback = document.querySelector('#form-feedback');

downloadForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!mediaUrl.value.trim()) {
    feedback.textContent = 'Paste a media link to continue.';
    mediaUrl.focus();
    return;
  }
  feedback.textContent = 'The downloader service is not connected yet.';
});

mediaUrl.addEventListener('input', () => {
  feedback.textContent = '';
});