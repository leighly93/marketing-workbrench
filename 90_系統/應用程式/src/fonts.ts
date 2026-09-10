import { staticFile } from 'remotion';

const style = document.createElement('style');
style.textContent = `
  @font-face {
    font-family: 'Noto Sans TC';
    font-weight: 100 900;
    src: url('${staticFile('NotoSansTC-VF.ttf')}') format('truetype');
  }
`;
document.head.appendChild(style);
