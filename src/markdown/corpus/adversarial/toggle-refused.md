# Toggles that stay as the file wrote them

Attributes beyond a bare open:

<details open class="x">
<summary>S</summary>

Body.

</details>

A summary carrying markup:

<details>
<summary>A <b>bold</b> summary</summary>

Body.

</details>

An entity this bridge does not know:

<details>
<summary>A &quot;quoted&quot; summary</summary>

Body.

</details>

A bare ampersand, which would come back escaped:

<details>
<summary>A & B</summary>

Body.

</details>

One inside another:

<details>
<summary>Outer</summary>

<details>
<summary>Inner</summary>

Body.

</details>

</details>

An opening tag with nothing closing it:

<details>
<summary>Unclosed</summary>

Body.
