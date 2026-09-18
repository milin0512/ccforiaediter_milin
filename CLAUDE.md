# Git運用ルール

- 作業ブランチ（例: `claude/xxxxx`）に変更をコミット・プッシュしたら、そのブランチを **`main` にもマージしてプッシュする** こと。
  - GitHub Pagesは`main`を参照しているため、`main`に反映されないと公開ページに変更が反映されない。
  - 手順の例:
    ```
    git checkout -B main origin/main
    git merge --no-edit <作業ブランチ名>
    git push origin main
    git checkout <作業ブランチ名>
    ```
  - マージでコンフリクトが発生した場合は、無理に自動解決せずユーザーに確認すること。

## キャッシュ運用ルール

- `app.js` または `style.css` を変更するコミットでは、`index.html` が読み込んでいるクエリ文字列（`app.js?v=N` / `style.css?v=N`）の番号も必ず一緒に上げること。
  - 同一URLのままだと、既にそのURLを読み込んだことのあるブラウザ（特にiPhone/iPad Safari）がファイル本体の更新後も古い版をキャッシュから使い続けてしまい、「修正したのに公開ページに反映されていない」状態になる（2026-09-18、実際に発生）。
  - `index.html`自体を変更しないコミット（`.gitignore`やドキュメントのみの変更等）では不要。
