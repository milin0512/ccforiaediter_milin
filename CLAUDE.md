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
