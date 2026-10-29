# 今天你要背单词 

网址: 
上传单词书照片，AI 自动识别单词，并生成一篇包含这些单词的英语短文（单词加粗 + 中文翻译）。
<img width="2560" height="1346" alt="image" src="https://github.com/user-attachments/assets/58075faa-1a52-4e48-a36a-244ed37cbaa1" />
<img width="2560" height="1346" alt="image" src="https://github.com/user-attachments/assets/6b6bd850-5c86-4c72-9ffc-faf77504bc11" />



## 技术栈

| 组件 | 方案 | 费用 |
|------|------|------|
| 前端 + 后端 | Cloudflare Workers（单文件） | 免费（10 万次/天） |
| OCR 识别 | OCR.space | 免费（2.5 万次/月） |
| 生成文章 | DeepSeek API | 按量付费（约几厘/篇） |

## 目录结构

```
word-article/
├── worker.js    # 完整代码（后端 + 内嵌前端页面）
└── README.md    # 本说明文档
```

## 部署步骤（无需命令行，全程在网页后台操作）

### 第 1 步：创建 Worker

1. 打开 <https://dash.cloudflare.com> 并登录
2. 左侧菜单点击 **Workers 和 Pages**（Workers & Pages）
3. 点击 **创建**（Create）→ **创建 Worker**（Create Worker）
4. 给 Worker 起个名字，例如 `word-article`，点击 **部署**（Deploy）

### 第 2 步：粘贴代码

1. 进入刚创建的 Worker，点击右上角 **编辑代码**（Edit code）
2. 把在线编辑器里的默认代码**全部删掉**
3. 用记事本打开本目录下的 `worker.js`，**全选复制**全部内容
4. 粘贴到在线编辑器里
5. 点击右上角 **部署**（Deploy / Save and Deploy）

### 第 3 步：配置两个密钥（环境变量）

1. 在 Worker 页面，点击 **设置**（Settings）→ **变量和机密**（Variables and Secrets）
2. 点击 **添加**（Add），依次添加下面两个**机密变量**（类型选 Secret）：

| 变量名 | 值（填您的密钥） |
|--------|------------------|
| `OCR_API_KEY` | 您的 OCR.space API Key |
| `DEEPSEEK_API_KEY` | 您的 DeepSeek API Key |

3. 添加完成后，**重新部署**一次 Worker 让变量生效

> ⚠️ 密钥类型请务必选择 **Secret**（机密），这样它会被加密存储，不会泄露。

### 第 4 步：访问网站

部署完成后，您的网址是：

```
https://<您的Worker名字>.<您的子域>.workers.dev
```

例如 `https://word-article.xxxx.workers.dev`

在浏览器打开这个网址，即可开始使用。
