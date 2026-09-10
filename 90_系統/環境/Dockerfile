# 開發與合成資料驗證專用；不包含真實工作、OCR、Whisper 或模型。
FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d
WORKDIR /workbench
# 建置入口只接受 git archive 的已提交公開檔案，不使用本機資料夾。
COPY --chown=node:node . .
RUN chown node:node /workbench
USER node
RUN npm run setup && npm run init
CMD ["npm", "run", "verify"]
